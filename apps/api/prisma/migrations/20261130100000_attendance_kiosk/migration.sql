-- 7.0.0: kiosk / QR punch. Additive and OFF by default: kioskEnabled is false and no kiosk exists,
-- so every punch behaves exactly as before. The source enum gains KIOSK on every column using it.
ALTER TABLE `AttendanceSource` MODIFY `kind` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV', 'REGULARIZATION', 'KIOSK') NOT NULL;
ALTER TABLE `AttendanceEvent` MODIFY `source` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV', 'REGULARIZATION', 'KIOSK') NOT NULL;
ALTER TABLE `AttendanceRecord` MODIFY `source` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV', 'REGULARIZATION', 'KIOSK') NOT NULL;
ALTER TABLE `LeaveRequest` MODIFY `source` ENUM('WEB', 'API', 'WEBHOOK', 'MCP', 'CSV', 'REGULARIZATION', 'KIOSK') NOT NULL DEFAULT 'WEB';

ALTER TABLE `GlobalAttendanceSettings`
    ADD COLUMN `kioskEnabled` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `AttendanceKiosk` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `siteId` VARCHAR(191) NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `tokenHint` VARCHAR(8) NOT NULL,
    `keySalt` VARCHAR(64) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `createdById` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AttendanceKiosk_tokenHash_key`(`tokenHash`),
    INDEX `AttendanceKiosk_siteId_idx`(`siteId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AttendanceKiosk` ADD CONSTRAINT `AttendanceKiosk_siteId_fkey` FOREIGN KEY (`siteId`) REFERENCES `AttendanceSite`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `AttendanceKioskNonce` (
    `id` VARCHAR(191) NOT NULL,
    `kioskId` VARCHAR(64) NOT NULL,
    `userId` VARCHAR(64) NOT NULL,
    `nonce` VARCHAR(32) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AttendanceKioskNonce_userId_kioskId_nonce_key`(`userId`, `kioskId`, `nonce`),
    INDEX `AttendanceKioskNonce_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
