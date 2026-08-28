-- 3.15.0: a record of platform-wide maintenance broadcasts.
--
-- THE WINDOW ITSELF IS NOT STORED HERE, deliberately. It lives in each workspace's own
-- `MaintenanceSettings` row, which is what `middleware/auth.ts` gates on, what the SPA's 503
-- interceptor redirects for, and what the heartbeat re-checks. Duplicating the window in the
-- control plane would create a second source of truth that can disagree with the first, and "the
-- platform thinks we are in maintenance but the workspace does not" is a state with no owner.
--
-- What this table adds is the thing a per-tenant row cannot answer: did one broadcast reach all of
-- them, who sent it, and which workspaces did not take it.
--
-- PORTABILITY NOTE: written in canonical casing by hand — `prisma migrate diff` introspected off
-- Windows MariaDB emits lowercase table names (the 2.4.0 lesson, docs/DATABASE.md).

-- CreateTable
CREATE TABLE `PlatformMaintenanceBroadcast` (
    `id` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL,
    `scheduledStartAt` DATETIME(3) NULL,
    `scheduledEndAt` DATETIME(3) NULL,
    `message` VARCHAR(500) NULL,
    `actorLabel` VARCHAR(255) NOT NULL,
    `targetCount` INTEGER NOT NULL,
    `appliedCount` INTEGER NOT NULL,
    `failedCount` INTEGER NOT NULL,
    `notifiedCount` INTEGER NOT NULL DEFAULT 0,
    `emailedCount` INTEGER NOT NULL DEFAULT 0,
    `outcomes` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PlatformMaintenanceBroadcast_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
