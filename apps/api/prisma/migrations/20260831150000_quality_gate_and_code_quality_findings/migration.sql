-- 4.0.0: SonarQube and lint results become findings, and a quality gate becomes a resolve gate.
--
-- WHY THIS EXISTS. Every scanner this app already ingests reports the same shape of thing — a tool,
-- a rule, a file, a line, and a claim that either gets fixed or does not. SonarQube and ESLint are
-- no different, and building them a second table would mean a second fingerprint, a second
-- deduplication, a second verification ladder and a second set of routing rules, all of which would
-- immediately start drifting from the first. So they share `SecurityFinding`, and the two new enum
-- members are what tell them apart.
--
-- QUALITY and LINT are appended, NOT inserted next to SAST where a taxonomy would file them. MySQL
-- stores an ENUM as the ORDINAL of its member: append and `MODIFY … ENUM(…)` rewrites nothing but
-- the table definition (the column still fits in one byte, so it is an in-place alter); insert into
-- the middle and every existing row's stored ordinal has to be rewritten — a full table copy, on the
-- one table an org's scanners append to every night. The list is a storage layout, not a taxonomy.
-- The same argument `20260830130000_security_finding_identity_and_scan_runs` makes for
-- PENDING_VERIFICATION, and `packages/shared/src/index.ts` repeats it beside the constant so nobody
-- has to find this file to learn it.
--
-- WHICH OF THESE COUNT AS SECURITY is decided in code, not here. `securityFindingTypeDisciplines`
-- (packages/shared) maps every type onto "security" or "quality", and the risk score, the Security
-- Insights page, the weekly security digest and the per-ticket risk verdict all filter through it.
-- Deliberately NOT a stored column: derived from `type`, no row can disagree with itself, no
-- migration is needed to re-decide, and adding a type fails to compile until somebody chooses.
--
-- `QualityGateRun` is a separate table from `ScanRun`, and the distinction matters. A ScanRun is a
-- container for FINDINGS, and the verification machinery compares one run to the next to decide
-- whether a finding is gone — an empty run is therefore evidence that everything previously reported
-- has been fixed. A quality gate reports no findings at all; it is a pass/fail verdict about a
-- branch. Recording one as an empty ScanRun would make Sonar's gate webhook silently mark that
-- branch's whole backlog verified fixed, which is the exact opposite of what it says. Sonar's ISSUES
-- arrive separately, on `/findings/sonar`, and those do become findings with a real ScanRun.
--
-- Nothing in `QualityGateRun` is a foreign key, on purpose: Sonar knows a project key and a branch
-- name, and this app knows repositories and tickets. The resolve gate joins the two on BRANCH NAME
-- (see `assertQualityGateAllowsResolve` in services/ticket.service.ts), which is why `branch` is
-- indexed with the clock and `projectKey` is not indexed at all.
--
-- WHAT EXISTING ROWS DO:
--   * Every existing `SecurityFinding` and `ScanRun` keeps its type, its ordinal and its meaning.
--     Widening an enum by appending changes no row: the five original members keep ordinals 1-5 and
--     the two new ones take 6 and 7. Nothing is backfilled because nothing is missing — no existing
--     finding is a code smell, and re-deciding old rows is not something this migration could do
--     honestly even if it wanted to.
--   * Because every existing finding is a SECURITY-discipline type, every existing risk score, chart,
--     digest and verdict reads exactly as it did before this migration. The new discipline filter is
--     a no-op on today's data and only begins to matter the first time somebody posts a code smell.
--   * `QualityGateRun` starts EMPTY on every installation, and stays empty until an admin pastes the
--     webhook URL into SonarQube. Until then the resolve gate below has nothing to consult, and it
--     is off anyway.
--   * `GlobalTicketSettings.blockResolveOnFailingQualityGate` defaults to FALSE for every existing
--     workspace, so no ticket that could be resolved yesterday is blocked today. It is the sibling of
--     `blockResolveOnFailingTests` and is off by default for the same reason: a rule that stops
--     people mid-workflow should be one somebody switched on.
--
-- THERE IS NO BACKFILL IN THIS FILE (see above), and the DDL is guarded anyway. The two enum
-- restatements need no guard because repeating them is a no-op — restating a column definition that
-- already matches changes nothing — while the ADD COLUMN uses the information_schema + PREPARE guard
-- and the CREATE TABLE uses `IF NOT EXISTS`, so a re-run after a partial failure is a no-op rather
-- than a duplicate-column error. `20260817100000_session_device_identity` is the incident that made
-- that the house rule. The file deliberately does NOT carry the auto-heal marker (the one
-- scripts/lib/migration-recovery.ts looks for in a SQL comment, spelled out in docs/DATABASE.md and
-- NOT repeated here, because writing it down at all is what sets it). That marker authorises
-- `npm run setup` to clear a failed record and re-apply UNATTENDED against real data, which is a
-- promise worth making only for the migration that needs auto-healing, not for every safe one.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- AlterTable
-- The sixth and seventh finding types. A full restatement of the column is how MySQL adds an enum
-- member; there is no additive form. Repeating this statement is harmless, which is why it needs no
-- guard. Both tables carry the same enum and both must be restated — a `SecurityFinding` that can be
-- QUALITY and a `ScanRun` that cannot would reject the run the ingest creates for it.
ALTER TABLE `SecurityFinding` MODIFY `type` ENUM('SAST', 'DAST', 'SSAT', 'SSCT', 'VAPT', 'QUALITY', 'LINT') NOT NULL;

-- AlterTable
ALTER TABLE `ScanRun` MODIFY `type` ENUM('SAST', 'DAST', 'SSAT', 'SSCT', 'VAPT', 'QUALITY', 'LINT') NOT NULL;

-- CreateTable
-- `IF NOT EXISTS` so a re-run after a partial failure reaches the statements below rather than dying
-- here. It is the portable spelling MySQL and MariaDB agree on, unlike `ADD COLUMN IF NOT EXISTS`,
-- which is MariaDB-only and is why the column further down uses the information_schema guard instead.
-- `conditions` is JSON because nothing queries an individual condition: they are read back together
-- to show a human WHY a gate failed, and a child table would buy a join and cost a migration every
-- time Sonar adds a field to one.
CREATE TABLE IF NOT EXISTS `QualityGateRun` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(40) NOT NULL,
    `serverUrl` VARCHAR(500) NULL,
    `taskId` VARCHAR(120) NULL,
    `projectKey` VARCHAR(255) NOT NULL,
    `projectName` VARCHAR(255) NULL,
    `branch` VARCHAR(255) NULL,
    `commitSha` VARCHAR(64) NULL,
    `analysisStatus` VARCHAR(20) NOT NULL,
    `gateName` VARCHAR(255) NULL,
    `status` ENUM('OK', 'WARN', 'ERROR') NOT NULL,
    `conditions` JSON NULL,
    `analysedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `QualityGateRun_branch_analysedAt_idx`(`branch`, `analysedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
-- The resolve gate's switch. NOT NULL DEFAULT false, so every existing row acquires it with the
-- answer that changes nothing.
SET @stmt := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE `GlobalTicketSettings` ADD COLUMN `blockResolveOnFailingQualityGate` BOOLEAN NOT NULL DEFAULT false',
    'DO 0'
  )
  FROM `information_schema`.`COLUMNS`
  WHERE `TABLE_SCHEMA` = DATABASE()
    AND `TABLE_NAME` = 'GlobalTicketSettings'
    AND `COLUMN_NAME` = 'blockResolveOnFailingQualityGate'
);
PREPARE `guarded_stmt` FROM @stmt;
EXECUTE `guarded_stmt`;
DEALLOCATE PREPARE `guarded_stmt`;
