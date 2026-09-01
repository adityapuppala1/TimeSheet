-- Unreleased: the engine store — one row per attempt to put `llama-server` itself on this host's
-- disk, as opposed to a model's weights.
--
-- WHY THIS TABLE EXISTS AT ALL. The native block could download and verify a 940 MB model perfectly
-- and then dead-end at "install llama.cpp on this host and point NATIVE_AI_SERVER_BIN at the
-- binary". For a feature whose promise is "pick a model, download it, run it", that is not an
-- instruction, it is a wall. Acquiring the engine is now a button, and a button that spends minutes
-- of somebody's bandwidth needs the same job row the model downloader has: this codebase has no SSE
-- and no WebSocket, so the house pattern for long work is a row polled by react-query with a
-- conditional refetchInterval, and a row also survives the restart an in-memory job loses silently.
--
-- WHY NOT A ROW IN `NativeModelDownload`. Same shape of job, almost nothing else in common: one has
-- a catalogue id, GGUF magic bytes and a derived-size band; the other has a release tag, zip magic
-- bytes, an extraction with a path-traversal refusal, and a "does the binary answer when we run it"
-- probe. Sharing a table would leave half the columns NULL on every row and make `status` mean two
-- different things depending on the kind. What IS shared is the TRANSFER — the redirect-following
-- stream that re-checks its allowlist on every hop, and the one-pass hash — which
-- native-model-store.service.ts now exports for both.
--
-- WHY `releaseTag` IS STORED AND NOT DERIVED. The pin can move (a release of ours bumps the
-- constant; an operator sets NATIVE_AI_ENGINE_RELEASE). Derived, "which llama.cpp is this box
-- running" would silently start describing the build that WOULD be installed rather than the one
-- that is.
--
-- WHY `binaryPath` IS NULL UNTIL THE BINARY HAS RUN. "Installed" is not "the archive extracted" —
-- an ABI-mismatched or wrong-architecture binary extracts perfectly and then fails at first
-- inference, minutes later, as somebody else's bug. The version probe is what promotes a row to
-- `ready`, and this column is the record that it passed.
--
-- WHY THE BYTE COUNTS ARE DOUBLE AND NOT BIGINT: the same reason NativeModelDownload gives. Prisma
-- maps BIGINT to a JS BigInt, which `JSON.stringify` throws on, so every route returning one needs a
-- bespoke serialiser and the one that forgets fails in production rather than in tests. A double is
-- exact for integers to 2^53 against a 26 MB archive.
--
-- WHAT EXISTING ROWS DO: there are none. This migration creates one table and touches nothing else —
-- no column altered, no row read, no data backfilled, no existing behaviour changed. A deployment
-- that never opens the native settings screen never gets a row in it.
--
-- NO DDL/DML MIXING, so no information_schema + PREPARE guard is needed: `CREATE TABLE IF NOT
-- EXISTS` is idempotent on its own and nothing follows it. The file deliberately does NOT carry the
-- auto-heal marker (scripts/lib/migration-recovery.ts, documented in docs/DATABASE.md) — that marker
-- authorises an UNATTENDED re-apply against real data, a promise worth making only for the migration
-- that needs it.
--
-- PORTABILITY NOTE: canonical casing written by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- CreateTable
CREATE TABLE IF NOT EXISTS `NativeEngineInstall` (
    `id` VARCHAR(191) NOT NULL,
    -- queued | downloading | verifying | installing | ready | failed | cancelled
    `status` VARCHAR(20) NOT NULL DEFAULT 'queued',
    -- The llama.cpp release this attempt installed, e.g. 'b6099'. Never 'latest'.
    `releaseTag` VARCHAR(20) NOT NULL,
    `assetName` VARCHAR(200) NOT NULL,
    `sourceUrl` VARCHAR(1000) NOT NULL,
    `bytesDownloaded` DOUBLE NOT NULL DEFAULT 0,
    -- NULL means the server sent no Content-Length. A real outcome, not zero.
    `bytesTotal` DOUBLE NULL,
    -- Measured from the archive that arrived, never the published-size ballpark shown before the click.
    `fileSizeBytes` DOUBLE NULL,
    -- Recorded, not compared — this project has no independently-obtained checksum for the asset.
    `sha256` CHAR(64) NULL,
    -- Set only after the extracted binary has been RUN and answered. NULL is what 'not installed'
    -- looks like, including for a row whose archive arrived perfectly.
    `binaryPath` VARCHAR(500) NULL,
    `versionOutput` VARCHAR(500) NULL,
    `error` TEXT NULL,
    `requestedById` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `NativeEngineInstall_status_idx`(`status`),
    INDEX `NativeEngineInstall_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
