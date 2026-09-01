-- Unreleased: the model store — one row per GGUF file this deployment has, or is fetching, on its
-- own disk.
--
-- WHY A TABLE AND NOT AN IN-MEMORY JOB. Fetching a five-gigabyte model takes minutes, and this
-- codebase has no SSE and no WebSocket: the house pattern for long-running work is a row polled by
-- react-query with a conditional `refetchInterval` (AgentRunsCard, AIEvalsCard). A row also survives
-- the restart an in-memory job loses silently, which is the failure an operator experiences as "the
-- progress bar vanished and nothing happened".
--
-- WHY THE JOB IS ALSO THE INVENTORY. A model on this disk got there by being downloaded, so the
-- job's terminal `ready` state IS the record that the file exists. A separate inventory table would
-- be a second row that must agree with this one about a single file, and the day they disagree is
-- the day a delete removes the file and the inventory still claims it is there.
--
-- WHY `modelId` IS UNIQUE. One catalogue entry, one file on disk, one row. Retrying a failed
-- download reuses the row instead of accumulating attempts — this is a store, not an audit log, and
-- AuditLog already records who asked for what and when.
--
-- WHY THE BYTE COUNTS ARE DOUBLE AND NOT BIGINT. The same reason the control plane's TenantDbSample
-- gives: Prisma maps BIGINT to a JS BigInt, which `JSON.stringify` throws on, so every route that
-- returns one needs a bespoke serialiser and the one that forgets fails in production rather than in
-- tests. A double is exact for integers up to 2^53 — nine petabytes — against a five-gigabyte file.
-- The precision BIGINT would buy here is worth nothing and costs a whole class of runtime error.
--
-- WHY BOTH A SIZE AND A HASH, WHEN THE CATALOGUE ALREADY ESTIMATES A SIZE. The catalogue's figure is
-- DERIVED from the quantisation's published bits-per-weight and is documented as such (see
-- packages/shared/src/native-models.ts). These two columns are what actually arrived: the size is
-- what every downstream fit estimate then prefers, and the hash is evidence a support conversation
-- can use to prove two installations hold the same weights. The hash is recorded, NOT compared —
-- the catalogue publishes no hashes, and asserting one this project cannot verify would be worse
-- than admitting the gap.
--
-- WHAT EXISTING ROWS DO: there are none. This migration creates one table and touches nothing else —
-- no column is altered, no row is read, no data is backfilled, and no existing behaviour changes.
-- A workspace that never opens the native settings screen never gets a row in it.
--
-- NO DDL/DML MIXING, so no information_schema + PREPARE guard is needed here: `CREATE TABLE IF NOT
-- EXISTS` is idempotent on its own, and there is nothing after it that could fail half-way. The file
-- deliberately does NOT carry the auto-heal marker (the one scripts/lib/migration-recovery.ts looks
-- for, documented in docs/DATABASE.md) — that marker authorises an UNATTENDED re-apply against real
-- data, which is a promise worth making only for the migration that needs it.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- CreateTable
CREATE TABLE IF NOT EXISTS `NativeModelDownload` (
    `id` VARCHAR(191) NOT NULL,
    -- A `nativeModelCatalogue` id. Stored, not referenced: the catalogue ships in the build, so a
    -- later release may drop an entry somebody already downloaded, and that has to render as
    -- "unknown model — delete it" rather than as a dangling relation.
    `modelId` VARCHAR(80) NOT NULL,
    -- queued | downloading | verifying | ready | failed | cancelled
    `status` VARCHAR(20) NOT NULL DEFAULT 'queued',
    `bytesDownloaded` DOUBLE NOT NULL DEFAULT 0,
    -- NULL means the server sent no Content-Length. That is a real outcome, not zero, and the
    -- progress bar renders indeterminate for it.
    `bytesTotal` DOUBLE NULL,
    -- Measured from the finished file; preferred over the catalogue's derived estimate everywhere.
    `fileSizeBytes` DOUBLE NULL,
    `sha256` CHAR(64) NULL,
    `filePath` VARCHAR(500) NULL,
    `sourceUrl` VARCHAR(1000) NULL,
    `error` TEXT NULL,
    -- The benchmark, which replaces the fit estimator's assumed generation speed with a measured
    -- one. `suggestedMaxOutputTokens` is what AIProviderConfig.maxOutputTokens should hold.
    `benchmarkedAt` DATETIME(3) NULL,
    `timeToFirstTokenMs` INTEGER NULL,
    `tokensPerSecond` DOUBLE NULL,
    `benchmarkOutputTokens` INTEGER NULL,
    `benchmarkTotalMs` INTEGER NULL,
    `suggestedMaxOutputTokens` INTEGER NULL,
    `requestedById` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NativeModelDownload_modelId_key`(`modelId`),
    INDEX `NativeModelDownload_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
