-- Per-capability AI autonomy — see services/ai-capability.registry.ts and ai-autonomy.service.ts.
--
-- BEHAVIOURAL CHANGE ON UPGRADE: none, and that is checkable. `aiAutonomyEnabled` defaults to
-- false, and NO AiCapabilityPolicy rows are created — an absent row means SUGGEST, which is the
-- only behaviour this product had before today. So immediately after this migration
-- `resolveAutonomy()` returns SUGGEST for every capability, exactly as if the table were not there.
--
-- WHY NO BACKFILL ROWS: a capability shipped by a later release must arrive at the floor in every
-- existing workspace rather than inheriting a neighbour's setting. Storing only what an
-- administrator explicitly chose is what makes that true without any per-release migration.

-- AlterTable
ALTER TABLE `GlobalAISettings` ADD COLUMN `aiAutonomyEnabled` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `AiCapabilityPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `capability` VARCHAR(60) NOT NULL,
    `level` ENUM('SUGGEST', 'AUTO_APPLY', 'AUTONOMOUS') NOT NULL DEFAULT 'SUGGEST',
    `maxChangesPerRun` INTEGER NULL,
    `maxRunsPerDay` INTEGER NULL,
    `maxCostUsdPerRun` DECIMAL(10, 4) NULL,
    `undoWindowHours` INTEGER NULL,
    `scopeProjectIds` JSON NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    UNIQUE INDEX `AiCapabilityPolicy_capability_key`(`capability`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AiCapabilityPolicy` ADD CONSTRAINT `AiCapabilityPolicy_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
