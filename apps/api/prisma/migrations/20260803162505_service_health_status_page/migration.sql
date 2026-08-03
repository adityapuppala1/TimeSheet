-- CreateTable
CREATE TABLE `ServiceHealthSample` (
    `id` VARCHAR(191) NOT NULL,
    `service` VARCHAR(60) NOT NULL,
    `status` ENUM('OPERATIONAL', 'DEGRADED', 'DOWN') NOT NULL,
    `latencyMs` INTEGER NULL,
    `detail` VARCHAR(500) NULL,
    `checkedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ServiceHealthSample_service_checkedAt_idx`(`service`, `checkedAt`),
    INDEX `ServiceHealthSample_checkedAt_idx`(`checkedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ServiceIncident` (
    `id` VARCHAR(191) NOT NULL,
    `service` VARCHAR(60) NOT NULL,
    `status` ENUM('OPERATIONAL', 'DEGRADED', 'DOWN') NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,
    `detail` VARCHAR(500) NULL,
    `sampleCount` INTEGER NOT NULL DEFAULT 1,

    INDEX `ServiceIncident_service_startedAt_idx`(`service`, `startedAt`),
    INDEX `ServiceIncident_endedAt_idx`(`endedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
