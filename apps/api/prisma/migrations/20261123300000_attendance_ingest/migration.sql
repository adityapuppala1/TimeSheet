-- V17 A3: attendance ingest from any source.
-- ApiKey.grants: NULL for every existing key = no attendance access (nothing working changes).
ALTER TABLE `ApiKey` ADD COLUMN `grants` VARCHAR(255) NULL;

-- The webhook secret encrypted at rest (an HMAC verifier needs the secret, not a hash of it).
ALTER TABLE `AttendanceSource` ADD COLUMN `secretEncrypted` TEXT NULL;

-- Conflict priorities for sourceless punches. Defaults: API > WEB = MCP > CSV; webhooks rank 1000+.
ALTER TABLE `GlobalAttendanceSettings`
    ADD COLUMN `apiPriority` INTEGER NOT NULL DEFAULT 30,
    ADD COLUMN `webPriority` INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN `mcpPriority` INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN `csvPriority` INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE `AttendanceEvent` (
    `id` VARCHAR(191) NOT NULL,
    `source` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV') NOT NULL,
    `sourceId` VARCHAR(191) NULL,
    `status` ENUM('ACCEPTED', 'DUPLICATE', 'SUPERSEDED', 'UNMATCHED', 'REJECTED') NOT NULL,
    `reason` VARCHAR(255) NULL,
    `dedupeKey` VARCHAR(255) NULL,
    `externalRef` VARCHAR(191) NULL,
    `identifier` VARCHAR(191) NULL,
    `userId` VARCHAR(191) NULL,
    `recordId` VARCHAR(191) NULL,
    `workDate` DATE NULL,
    `punchInAt` DATETIME(3) NULL,
    `punchOutAt` DATETIME(3) NULL,
    `isTest` BOOLEAN NOT NULL DEFAULT false,
    `input` JSON NULL,
    `rawPayload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AttendanceEvent_dedupeKey_key`(`dedupeKey`),
    INDEX `AttendanceEvent_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `AttendanceEvent_sourceId_createdAt_idx`(`sourceId`, `createdAt`),
    INDEX `AttendanceEvent_recordId_idx`(`recordId`),
    INDEX `AttendanceEvent_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AttendanceEvent` ADD CONSTRAINT `AttendanceEvent_sourceId_fkey` FOREIGN KEY (`sourceId`) REFERENCES `AttendanceSource`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
