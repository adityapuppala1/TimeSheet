-- 7.0.0: geofenced work sites. Additive only and OFF by default: no sites exist and requireSite is
-- OFF, so every punch keeps exactly the labels it had until an admin defines a site.
ALTER TABLE `GlobalAttendanceSettings`
    ADD COLUMN `requireSite` ENUM('OFF', 'BLOCK', 'ALLOW_FLAGGED') NOT NULL DEFAULT 'OFF';

ALTER TABLE `AttendanceRecord`
    ADD COLUMN `siteLabel` VARCHAR(140) NULL,
    ADD COLUMN `siteFlagged` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `AttendanceSite` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `latitude` DECIMAL(9, 6) NOT NULL,
    `longitude` DECIMAL(9, 6) NOT NULL,
    `radiusM` INTEGER NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AttendanceSite_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
