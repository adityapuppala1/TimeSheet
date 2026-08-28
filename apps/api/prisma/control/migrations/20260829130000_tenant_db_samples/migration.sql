-- 4.0.0: an hourly reading of every workspace's database, so the console can draw a TREND.
--
-- A single measurement answers "how big is it". A series answers the questions an operator actually
-- has: is it growing, when does it cross the plan's ceiling, did the index we added on Tuesday
-- change anything, and was the box under load when that spike was taken.
--
-- WHY THE SIZES ARE DOUBLE AND NOT BIGINT: Prisma maps BIGINT to a JS BigInt, which JSON.stringify
-- throws on — so every route returning one needs a bespoke serialiser and the one that forgets
-- fails in production rather than in tests. A double is exact for integers to 2^53, which is nine
-- petabytes. The precision that buys nothing costs a whole class of runtime error.
--
-- AGGREGATE ONLY: sizes, counts and server counters. No table names, no row contents — the same
-- line every other platform-console surface holds.
--
-- PORTABILITY NOTE: canonical casing by hand — `prisma migrate diff` introspected off Windows
-- MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- CreateTable
CREATE TABLE `TenantDbSample` (
    `id` VARCHAR(191) NOT NULL,
    `organizationId` VARCHAR(191) NOT NULL,
    `sampledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `totalBytes` DOUBLE NOT NULL,
    `dataBytes` DOUBLE NOT NULL,
    `indexBytes` DOUBLE NOT NULL,
    `freeBytes` DOUBLE NOT NULL,
    `tableCount` INTEGER NOT NULL,
    `estimatedRows` DOUBLE NOT NULL,
    `queryMs` INTEGER NOT NULL,
    `connectionUsePercent` DOUBLE NULL,
    `bufferPoolHitRate` DOUBLE NULL,
    `slowQueries` DOUBLE NULL,

    INDEX `TenantDbSample_organizationId_sampledAt_idx`(`organizationId`, `sampledAt`),
    INDEX `TenantDbSample_sampledAt_idx`(`sampledAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TenantDbSample` ADD CONSTRAINT `TenantDbSample_organizationId_fkey`
    FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
